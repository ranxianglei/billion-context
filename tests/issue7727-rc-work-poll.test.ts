import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { getUnrecognizedPathStats, isRcWorkPollPath } from "../src/server/observability.ts";

// #7727: Claude Code Remote Control long-polls /v1/environments/<env>/work/poll
// (about once a second per registered session, each on a fresh MITM tunnel). It
// is a known, expected passthrough — never compressed — so it must be exempt
// from the "unrecognized path" warn/stats, like isModelDiscoveryPath /
// isV1InternalControlPlanePath. These tests pin the predicate (both directions)
// and the gate wiring (exempt path not recorded; a genuinely unknown path still
// recorded — the positive control that proves the exemption, not a dead gate).

const ENV_ID = "env-0123456789abcdef";
const POLL_PATH = `/v1/environments/${ENV_ID}/work/poll`;

// --- Predicate: both directions, prefixed and non-prefixed, with/without query.

test("isRcWorkPollPath matches the RC work-poll endpoint (positive)", () => {
    assert.equal(isRcWorkPollPath(POLL_PATH), true, "plain path");
    assert.equal(isRcWorkPollPath(`${POLL_PATH}?timeout=30`), true, "query string stripped");
    assert.equal(isRcWorkPollPath(`${POLL_PATH}/`), true, "trailing slash tolerated");
    // Routing prefix (/bili/<origin>/…) must not defeat the exemption — the
    // same reason isV1InternalControlPlanePath matches by suffix.
    assert.equal(isRcWorkPollPath(`/bili/http://relay.internal:8443${POLL_PATH}`), true, "tunnel prefix");
    assert.equal(isRcWorkPollPath(`/v1/environments/other-env-9/work/poll`), true, "different env id");
});

test("isRcWorkPollPath rejects look-alikes (negative)", () => {
    assert.equal(isRcWorkPollPath(`/v1/environments/${ENV_ID}/work/status`), false, "sibling endpoint");
    assert.equal(isRcWorkPollPath(`/v1/environments/${ENV_ID}/work/poll/extra`), false, "extra segment after poll");
    assert.equal(isRcWorkPollPath(`/v1/environments//work/poll`), false, "empty env id");
    assert.equal(isRcWorkPollPath(`/v1/environments/${ENV_ID}/work`), false, "missing poll segment");
    assert.equal(isRcWorkPollPath(`/v1/messages`), false, "model path");
    assert.equal(isRcWorkPollPath(`/chat/completions`), false, "openai path");
    assert.equal(isRcWorkPollPath(`/xv1/environments/${ENV_ID}/work/poll`), false, "glued prefix segment");
    assert.equal(isRcWorkPollPath("/v1/environments"), false, "bare prefix");
    assert.equal(isRcWorkPollPath(""), false, "empty");
});

// --- Gate wiring: the exempt path is not recorded; a real unknown path is.

type Call = { path: string; raw: string };

function makeUpstream(calls: Call[]): http.Server {
    return http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            calls.push({ path: req.url ?? "", raw });
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
        });
    });
}

function startProxy(upstreamPort: number): Promise<http.Server> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    return startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: 10_000 } } } },
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

async function drive(proxyPort: number, upstreamPort: number, path: string, body: unknown): Promise<{ status: number; text: string }> {
    const resp = await fetch(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    return { status: resp.status, text: await resp.text() };
}

// The stats key is the masked URL (private host → placeholder); the path part is
// kept, so a path substring is a stable lookup.
function countOf(substring: string): number {
    let n = 0;
    for (const [k, v] of Object.entries(getUnrecognizedPathStats().paths)) if (k.includes(substring)) n += v;
    return n;
}

test("#7727: the RC work-poll path is exempt from unrecognized-path stats; a real unknown path is still recorded", async () => {
    const pollBefore = countOf("work/poll");
    const unknownMarker = `zz-unknown-${Date.now()}`;
    const unknownBefore = countOf(unknownMarker);

    const calls: Call[] = [];
    const upstream = makeUpstream(calls);
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startProxy(upstreamPort);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        // The RC work-poll: forwarded, but must NOT be recorded as unrecognized.
        const poll = await drive(proxyPort, upstreamPort, POLL_PATH, { tick: 1 });
        assert.equal(poll.status, 200, `work-poll passthrough must succeed, got HTTP ${poll.status}: ${poll.text.slice(0, 200)}`);
        assert.equal(countOf("work/poll"), pollBefore, "RC work-poll leaked into unrecognized-path stats");

        // Positive control: a genuinely unknown path in the SAME form must be
        // recorded — proves the gate is live and the poll's absence is the
        // exemption, not a dead gate.
        const unknown = await drive(proxyPort, upstreamPort, `/${unknownMarker}`, { x: 1 });
        assert.equal(unknown.status, 200, `unknown-path passthrough must succeed, got HTTP ${unknown.status}: ${unknown.text.slice(0, 200)}`);
        assert.ok(countOf(unknownMarker) > unknownBefore, "genuinely unknown path was NOT recorded — gate is dead?");
    } finally {
        proxy.close();
        upstream.close();
    }
});
