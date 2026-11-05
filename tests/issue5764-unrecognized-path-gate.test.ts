import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import {
    getUnrecognizedPathStats,
    logUnrecognizedPath,
    _resetUnrecognizedPathStatsForTest,
    UNRECOGNIZED_PATH_TTL_MS,
} from "../src/server/observability.ts";

// #5764: the UNRECOGNIZED PATHS counter fired on `protocol === null`, which
// conflated three unrelated states into one diagnostic:
//   (1) non-POST probes/scans/enumeration (HEAD /responses, GET /models, a GET
//       path-brute-force) — no body to compress, never going to be compressed,
//       yet flagged "not a known protocol" (the headline false positive);
//   (2) a decode failure on a KNOWN path (the decode step nulls `protocol`);
//   (3) a genuinely unknown path reached by a model call (POST + body).
// Only (3) belongs in the counter. And the counter was a since-start ledger that
// never cleared, so a one-off probe stayed resident on the acp_status panel for
// days. These tests pin both facets: the method/path gate AND the TTL windowing.

function makeUpstream(): http.Server {
    return http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
    });
}

function startProxy(upstreamPort: number): Promise<http.Server> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    return startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: `http://127.0.0.1:${upstreamPort}`,
        routes: {},
        modelContextLimit: 10_000,
        kernelConfig: defaultConfig(10_000),
        compress: { injectTool: true, injectNudge: true },
        sessionHeader: "x-acp-session",
        log: false,
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
    } as unknown as ProxyOptions);
}

// Drive a raw request through the /bili/<absolute-url> tunnel. The response body
// is irrelevant here — what we assert is the SERVER-SIDE unrecognized-path state,
// so a post-response socket teardown on the client side must not fail the test.
async function driveRaw(proxyPort: number, upstreamPort: number, method: string, path: string, body?: string): Promise<void> {
    await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}${path}`, {
        method,
        headers: body !== undefined ? { "content-type": "application/json" } : undefined,
        body,
    }).then((r) => r.text()).catch(() => { /* server-side state is what's asserted */ });
}

test("#5764: non-POST to a KNOWN endpoint and non-POST scans are not counted; a model-call to an unknown path is", async () => {
    _resetUnrecognizedPathStatsForTest();
    const upstream = makeUpstream();
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        // Evidence 1: HEAD to a KNOWN protocol endpoint (/responses). The old gate
        // flagged this "not a known protocol" even though /responses IS in the table.
        await driveRaw(proxyPort, upstreamPort, "HEAD", "/responses");
        // Evidence 2: a GET brute-force probe of an unknown path.
        await driveRaw(proxyPort, upstreamPort, "GET", "/totally-unknown-scan");
        const mid = getUnrecognizedPathStats();
        assert.equal(mid.total, 0, "non-POST probes/scans leave no unrecognized-path trace");

        // Preserved signal: a MODEL CALL (POST + body) to a genuinely unknown path
        // still counts — that is the real "expected compression but path unhandled".
        await driveRaw(proxyPort, upstreamPort, "POST", "/totally-unknown-modelcall", JSON.stringify({ foo: "bar" }));
        const after = getUnrecognizedPathStats();
        assert.equal(after.total, 1, "model-call to unknown path still counted");
        assert.ok(Object.values(after.paths).includes(1), "counted under exactly one path");
    } finally {
        proxy.close();
        upstream.close();
    }
});

test("#5764: stats expose ISO firstSeen/lastSeen additively over paths/total", () => {
    _resetUnrecognizedPathStatsForTest();
    const url = "https://unit-5764.example/some/unknown/path";
    logUnrecognizedPath(() => {}, url);
    const s = getUnrecognizedPathStats();
    const key = Object.keys(s.paths)[0];
    assert.ok(key, "one path recorded");
    assert.equal(s.paths[key], 1, "paths keeps its Record<string,number> shape");
    assert.equal(s.total, 1);
    assert.ok(s.lastSeen?.[key] && !Number.isNaN(Date.parse(s.lastSeen[key])), "lastSeen is a parseable ISO timestamp");
    assert.ok(s.firstSeen?.[key] && !Number.isNaN(Date.parse(s.firstSeen[key])), "firstSeen is a parseable ISO timestamp");
});

test("#5764: entries older than the TTL drop out of stats (no permanent residency)", (t) => {
    _resetUnrecognizedPathStatsForTest();
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const url = "https://ttl-5764.example/stale/path";
    logUnrecognizedPath(() => {}, url);
    assert.equal(getUnrecognizedPathStats().total, 1, "present right after the hit");
    now += UNRECOGNIZED_PATH_TTL_MS + 60_000;
    const stale = getUnrecognizedPathStats();
    assert.equal(stale.total, 0, "stale entry pruned after the TTL window");
    assert.deepEqual(stale.paths, {}, "no paths linger past the window");
});

test("#5764: a repeat hit within the window bumps count + lastSeen, keeps firstSeen", (t) => {
    _resetUnrecognizedPathStatsForTest();
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    const url = "https://repeat-5764.example/path";
    logUnrecognizedPath(() => {}, url);
    const first = getUnrecognizedPathStats();
    const key = Object.keys(first.paths)[0];
    now += 5 * 60 * 1000;
    logUnrecognizedPath(() => {}, url);
    const second = getUnrecognizedPathStats();
    assert.equal(second.paths[key], 2, "count accumulated within the window");
    assert.equal(second.firstSeen?.[key], first.firstSeen?.[key], "firstSeen stable across repeats");
    assert.notEqual(second.lastSeen?.[key], first.lastSeen?.[key], "lastSeen advanced on the repeat");
});

test("#5764: reset seam clears the windowed map", () => {
    _resetUnrecognizedPathStatsForTest();
    logUnrecognizedPath(() => {}, "https://reset-5764.example/a");
    assert.equal(getUnrecognizedPathStats().total, 1);
    _resetUnrecognizedPathStatsForTest();
    assert.equal(getUnrecognizedPathStats().total, 0);
});
