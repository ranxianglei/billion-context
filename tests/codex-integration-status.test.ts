import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    codexRouteRecordPath,
    writeCodexRouteRecord,
} from "../src/codex-integration/route.ts";
import { inspectCodexIntegration } from "../src/codex-integration/status.ts";

/** Responses where `lastSeenMs` is absent (older proxy build) — the ISO
 *  `lastSeen` string must still prove freshness, otherwise a user whose
 *  scheduled service predates the numeric field never reaches `verified`. */
function isoOnlyFetch(options: { ageMs: number }) {
    return async (input: string | URL | Request): Promise<Response> => {
        const url = String(input);
        if (url.endsWith("/__bili/health"))
            return Response.json({ ok: true }, { status: 200 });
        if (url.endsWith("/__bili/stats"))
            return Response.json({
                sessions: [
                    {
                        codexClient: true,
                        requests: 2,
                        lastSeen: new Date(Date.now() - options.ageMs).toISOString(),
                        lastSeenMs: null,
                    },
                ],
            });
        return new Response("not found", { status: 404 });
    };
}

test("an ISO-only lastSeen still proves a fresh Codex request", async () => {
    const route = "http://127.0.0.1:18787/bili/https://api.kourichat.com/v1";
    const config = `model_provider = "custom"\n\n[model_providers.custom]\nbase_url = "${route}"\n`;
    const fresh = await inspectCodexIntegration({
        origin: "http://127.0.0.1:18787",
        codexConfigText: config,
        fetchImpl: isoOnlyFetch({ ageMs: 20_000 }),
    });
    assert.equal(fresh.state, "verified");
    // Beyond the evidence window a session is history, not current proof.
    const stale = await inspectCodexIntegration({
        origin: "http://127.0.0.1:18787",
        codexConfigText: config,
        fetchImpl: isoOnlyFetch({ ageMs: 25 * 60 * 60_000 }),
    });
    assert.notEqual(stale.state, "verified");
});

/** Codex evidence must survive a user idling for a while, but a session served
 *  from bili's own loopback test upstreams, or one whose hint names another
 *  client, must never count. */
test("loopback-fixture sessions and foreign clients are not Codex evidence", async () => {
    // The route is only "configured" once bili's sidecar record attests it —
    // a shape match alone is foreign by design (codex-route.test.ts).
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-codex-status-"));
    const file = path.join(home, "config.toml");
    const env = { ...process.env, CODEX_HOME: home };
    const origin = "http://127.0.0.1:18787";
    const route = `${origin}/bili/https://api.kourichat.com/v1`;
    const config = `model_provider = "custom"\n\n[model_providers.custom]\nbase_url = "${route}"\n`;
    try {
        fs.writeFileSync(file, config);
        writeCodexRouteRecord(codexRouteRecordPath(file), {
            schemaVersion: 1,
            writtenValue: route,
            previousValue: null,
            upstream: "https://api.kourichat.com/v1",
            target: { kind: "provider", provider: "custom" },
        });
        const withSession =
            (session: Record<string, unknown>) =>
            async (input: string | URL | Request): Promise<Response> => {
                const url = String(input);
                if (url.endsWith("/__bili/health"))
                    return Response.json({ ok: true }, { status: 200 });
                if (url.endsWith("/__bili/stats"))
                    return Response.json({
                        sessions: [
                            { requests: 1, lastSeenMs: Date.now() - 1000, ...session },
                        ],
                    });
                return new Response("not found", { status: 404 });
            };

        // A fake-E2E session (loopback upstream) plus an idle hour: still only configured.
        const fixture = await inspectCodexIntegration({
            env,
            origin,
            codexConfigText: config,
            fetchImpl: withSession({
                codexClient: true,
                protocol: "responses",
                upstream: `http://127.0.0.1:4805`,
            }),
        });
        assert.equal(fixture.state, "configured");

        // A Responses-protocol session with no client hint is Codex's.
        const hintless = await inspectCodexIntegration({
            env,
            origin,
            codexConfigText: config,
            fetchImpl: withSession({
                protocol: "responses",
                upstream: "https://api.kourichat.com",
            }),
        });
        assert.equal(hintless.state, "verified");

        // A hint naming another client vetoes an otherwise Codex-shaped session.
        const foreign = await inspectCodexIntegration({
            env,
            origin,
            codexConfigText: config,
            fetchImpl: withSession({
                codexClient: true,
                protocol: "responses",
                clientHint: "curl/8.0",
                upstream: "https://api.kourichat.com",
            }),
        });
        assert.equal(foreign.state, "configured");
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

function fakeFetch(options: {
    healthy: boolean;
    codexObserved?: boolean;
    codexAgeMs?: number;
}) {
    return async (input: string | URL | Request): Promise<Response> => {
        const url = String(input);
        if (url.endsWith("/__bili/health"))
            return Response.json(
                { ok: options.healthy },
                { status: options.healthy ? 200 : 503 },
            );
        if (url.endsWith("/__bili/stats"))
            return Response.json({
                sessions: options.codexObserved
                    ? [
                            {
                                codexClient: true,
                                requests: 1,
                                lastSeenMs: Date.now() - (options.codexAgeMs ?? 0),
                            },
                        ]
                    : [],
            });
        return new Response("not found", { status: 404 });
    };
}

test("Codex integration distinguishes proxy-ready, configured, verified, bypassed and unknown", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-codex-status-"));
    const file = path.join(home, "config.toml");
    const env = { ...process.env, CODEX_HOME: home };
    const origin = "http://127.0.0.1:18787";
    try {
        const ready = await inspectCodexIntegration({
            env,
            origin,
            codexConfigText: "",
            fetchImpl: fakeFetch({ healthy: true }),
        });
        assert.equal(ready.state, "proxy-ready");
        const route = `${origin}/bili/https://api.openai.com/v1`;
        const config = `openai_base_url = "${route}"\n`;
        fs.writeFileSync(file, config);
        writeCodexRouteRecord(codexRouteRecordPath(file), {
            schemaVersion: 1,
            writtenValue: route,
            previousValue: null,
            upstream: "https://api.openai.com/v1",
        });
        const configured = await inspectCodexIntegration({
            env,
            origin,
            codexConfigText: config,
            fetchImpl: fakeFetch({ healthy: true }),
        });
        assert.equal(configured.state, "configured");
        const verified = await inspectCodexIntegration({
            env,
            origin,
            codexConfigText: config,
            fetchImpl: fakeFetch({ healthy: true, codexObserved: true }),
        });
        assert.equal(verified.state, "verified");
        const stale = await inspectCodexIntegration({
            env,
            origin,
            codexConfigText: config,
            fetchImpl: fakeFetch({
                healthy: true,
                codexObserved: true,
                codexAgeMs: 25 * 60 * 60_000,
            }),
        });
        assert.equal(
            stale.state,
            "configured",
            "old Codex sessions are not current route proof",
        );

        const bypassed = await inspectCodexIntegration({
            env,
            origin,
            codexConfigText: 'openai_base_url = "https://relay.example/v1"\n',
            fetchImpl: fakeFetch({ healthy: true }),
        });
        assert.equal(bypassed.state, "bypassed");
        const unknown = await inspectCodexIntegration({
            env,
            origin,
            codexConfigText: "",
            fetchImpl: fakeFetch({ healthy: false }),
        });
        assert.equal(unknown.state, "unknown");
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});
