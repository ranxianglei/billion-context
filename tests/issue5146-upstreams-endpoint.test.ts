// #5146: GET /__bili/upstreams read surface — per-host merge of the alert table
// + open circuits that DSH's frame-level banner polls. The client half of #4254
// landed without this server half (its PR closed unmerged and the re-land kept
// only the egress fixes), so every shipped banner polled a route that 404'd AND
// got CORS-blocked per poll. Unit-tests the projection directly AND pins the
// HTTP surface: loopback/tunnel gating, ACAO echo for the cross-origin DSH
// reader, healthy empty list.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Readable } from "node:stream";
import { handleAdminRoute } from "../src/server/admin.ts";
import { BILI_TUNNEL_HEADER } from "../src/tunnel-guard.ts";
import {
    recordUpstreamAlert,
    recordUpstreamCircuitFailure,
    recordUpstreamCircuitSuccess,
    clearUpstreamAlertsForHost,
    getUpstreamHealthReport,
    _resetUpstreamAlertsForTest,
    _resetUpstreamCircuitsForTest,
    _setCircuitCooldownForTest,
} from "../src/upstream-alerts.js";

const A = "http://127.0.0.1:7864/v1/chat/completions";
const B = "http://10.0.0.5:9000/v1/chat/completions";
const NO_PORT = "http://relay.example.com/v1/chat/completions";

function refused(host: string): Error {
    return Object.assign(new Error(`connect ECONNREFUSED ${host}`), { code: "ECONNREFUSED" });
}

test("#5146: alert-only window → one entry per host, circuit null, kind/count/hint/code from the alert", () => {
    _resetUpstreamAlertsForTest();
    _resetUpstreamCircuitsForTest();
    recordUpstreamAlert(A, refused("127.0.0.1:7864"), false);
    const r = getUpstreamHealthReport();
    assert.equal(r.upstreams.length, 1);
    const e = r.upstreams[0];
    assert.equal(e.host, "127.0.0.1:7864");
    assert.equal(e.port, 7864);
    assert.equal(e.kind, "connect-refused");
    assert.equal(e.code, "ECONNREFUSED");
    assert.ok(typeof e.hint === "string" && e.hint.length > 0);
    assert.equal(e.count, 1);
    assert.equal(e.circuit, null);
});

test("#5146: open circuit is the authoritative down signal — merged row, state open, nextProbe ETA, circuit strikes", () => {
    _resetUpstreamAlertsForTest();
    _resetUpstreamCircuitsForTest();
    _setCircuitCooldownForTest(60_000);
    for (let i = 0; i < 3; i++) {
        recordUpstreamAlert(B, refused("10.0.0.5:9000"), false);
        recordUpstreamCircuitFailure(B, refused("10.0.0.5:9000"), false);
    }
    const e = getUpstreamHealthReport(Date.now()).upstreams[0];
    assert.equal(e.host, "10.0.0.5:9000");
    assert.equal(e.port, 9000);
    assert.ok(e.circuit, "circuit must be present while open");
    assert.equal(e.circuit?.state, "open");
    assert.ok(e.circuit && e.circuit.nextProbeInMs > 0 && e.circuit.nextProbeInMs <= 60_000);
    assert.equal(e.kind, "connect-refused");
    assert.equal(e.code, "ECONNREFUSED");
    assert.equal(e.count, 3, "count reflects circuit strikes while open");
});

test("#5146: multiple hosts merge into distinct rows; recovery (clear alerts + close circuit) drops the host", () => {
    _resetUpstreamAlertsForTest();
    _resetUpstreamCircuitsForTest();
    recordUpstreamAlert(A, refused("127.0.0.1:7864"), false);
    recordUpstreamAlert(B, refused("10.0.0.5:9000"), false);
    const hosts = new Set(getUpstreamHealthReport().upstreams.map((e) => e.host));
    assert.deepEqual([...hosts].sort(), ["10.0.0.5:9000", "127.0.0.1:7864"]);
    // Recovery on B: a resolved response clears its alerts AND closes any circuit.
    clearUpstreamAlertsForHost(B);
    recordUpstreamCircuitSuccess(B);
    const after = getUpstreamHealthReport().upstreams.map((e) => e.host);
    assert.deepEqual(after, ["127.0.0.1:7864"], "recovered host disappears, the other stays");
});

test("#5146: host with no explicit port projects port=null", () => {
    _resetUpstreamAlertsForTest();
    _resetUpstreamCircuitsForTest();
    recordUpstreamAlert(NO_PORT, refused("relay.example.com"), false);
    const e = getUpstreamHealthReport().upstreams[0];
    assert.equal(e.host, "relay.example.com");
    assert.equal(e.port, null);
});

// ── HTTP surface ─────────────────────────────────────────────────────────────

type AdminCtxForTest = Parameters<typeof handleAdminRoute>[2];

function makeCtx(): AdminCtxForTest {
    return {
        opts: { host: "127.0.0.1" },
        core: {},
        config: {},
        log: (): void => {},
        instanceId: "test-instance",
        instanceStartedAt: Date.now(),
        proxyWatchers: new Set<number>(),
        initialWatcherPid: null,
        bootReady: (): boolean => true,
        requestShutdown: (): void => {},
    } as unknown as AdminCtxForTest;
}

function mkReq(remoteAddress: string, extraHeaders: Record<string, string> = {}): http.IncomingMessage {
    // the trusted-origin gate verifies the Host header against the admin's
    // trusted hostnames, so bare loopback requests must carry it
    return Object.assign(new Readable({ read(): void {} }), {
        method: "GET",
        url: "/__bili/upstreams",
        headers: { host: "127.0.0.1", ...extraHeaders },
        socket: { remoteAddress },
    }) as unknown as http.IncomingMessage;
}

function mkRes(): { res: http.ServerResponse; out: { code?: number; headers?: Record<string, string>; body?: string } } {
    const out: { code?: number; headers?: Record<string, string>; body?: string } = {};
    const res = {
        writeHead(code: number, headers?: Record<string, string>): void { out.code = code; out.headers = headers ?? {}; },
        end(body?: string): void { out.body = body ?? ""; },
    };
    return { res: res as unknown as http.ServerResponse, out };
}

test("#5146: GET /__bili/upstreams answers the cross-origin DSH reader with ACAO echo + report", async () => {
    _resetUpstreamAlertsForTest();
    _resetUpstreamCircuitsForTest();
    recordUpstreamAlert(A, refused("127.0.0.1:7864"), false);
    const { res, out } = mkRes();
    await handleAdminRoute(mkReq("127.0.0.1", { origin: "http://127.0.0.1:43120" }), res, makeCtx());
    assert.equal(out.code, 200);
    assert.equal(out.headers?.["access-control-allow-origin"], "http://127.0.0.1:43120", "ACAO must echo the admitted origin");
    const doc = JSON.parse(out.body ?? "") as { upstreams: Array<{ host: string }> };
    assert.deepEqual(doc.upstreams.map((e) => e.host), ["127.0.0.1:7864"]);
});

test("#5146: healthy state → empty list, no ACAO without an Origin header (curl/health probes unchanged)", async () => {
    _resetUpstreamAlertsForTest();
    _resetUpstreamCircuitsForTest();
    const { res, out } = mkRes();
    await handleAdminRoute(mkReq("127.0.0.1"), res, makeCtx());
    assert.equal(out.code, 200);
    assert.equal(out.headers?.["access-control-allow-origin"], undefined, "no Origin → no ACAO");
    assert.deepEqual(JSON.parse(out.body ?? ""), { upstreams: [] });
});

test("#5146: non-loopback peers are refused before any payload is served", async () => {
    _resetUpstreamAlertsForTest();
    _resetUpstreamCircuitsForTest();
    recordUpstreamAlert(A, refused("127.0.0.1:7864"), false);
    const { res, out } = mkRes();
    await handleAdminRoute(mkReq("10.0.0.5", { origin: "http://127.0.0.1:43120" }), res, makeCtx());
    assert.equal(out.code, 403);
    assert.ok(!out.body?.includes("upstreams"), "no health payload on denial");
});

test("#5146: tunneled requests are refused even from loopback", async () => {
    _resetUpstreamAlertsForTest();
    _resetUpstreamCircuitsForTest();
    recordUpstreamAlert(A, refused("127.0.0.1:7864"), false);
    const { res, out } = mkRes();
    await handleAdminRoute(mkReq("127.0.0.1", { [BILI_TUNNEL_HEADER]: "1" }), res, makeCtx());
    assert.equal(out.code, 403);
});
