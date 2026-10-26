// #3581: when a plugin host's takeover gate degrades at runtime (disposed
// agent scope, disabled plugin), model traffic silently goes direct
// uncompressed until a host restart. The plugin reports its attribution
// health event-driven to POST /__bili/plugin/attribution; the proxy keeps
// the latest per agent and exposes it on BOTH status surfaces (#2152 parity)
// so the panel can show an explicit "takeover broken" notice instead of a
// bare "0 running". These tests pin the wire contract:
//   1. default is {} (no report yet) on both surfaces — identical payload;
//   2. a valid report lands per-agent and is byte-identical on
//      /__bili/status and /__bili/overview (one shared wire helper);
//   3. malformed reports are rejected loudly (400), never merged into
//      defaults or dropped fields (#155 discipline);
//   4. the page ships the banner element and the client references it plus
//      the localized copy key.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { _resetAttributionStatusForTest } from "../src/server/attribution-status.ts";
import { renderPage } from "../src/web/page.ts";
import { WEB_CLIENT } from "../src/web/client.ts";
import { VERSION } from "../src/version.ts";
import { rmrf } from "./tmp-rm.ts";

process.env.BILI_PERSIST_ZSTD = "0";

const ENV_KEYS = ["BILI_SESSIONS_DIR", "BILI_CONFIG_FILE", "XDG_CACHE_HOME", "XDG_STATE_HOME"] as const;
type EnvSnap = Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

function saveEnv(): EnvSnap {
    const snap: EnvSnap = {};
    for (const k of ENV_KEYS) snap[k] = process.env[k];
    return snap;
}

function restoreEnv(snap: EnvSnap): void {
    for (const k of ENV_KEYS) {
        if (snap[k] === undefined) delete process.env[k];
        else process.env[k] = snap[k];
    }
}

function isolate(base: string): void {
    mkdirSync(path.join(base, "sessions"), { recursive: true });
    process.env.BILI_SESSIONS_DIR = path.join(base, "sessions");
    process.env.BILI_CONFIG_FILE = path.join(base, "absent-config.json");
    process.env.XDG_CACHE_HOME = path.join(base, "cache");
    process.env.XDG_STATE_HOME = path.join(base, "state");
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function freePort(): Promise<number> {
    const server = http.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    await close(server);
    return port;
}

interface AttributionWireEntry {
    state: "ok" | "none" | "threw";
    refusals: number;
    since: number;
}

function makeOpts(upstreamPort: number): ProxyOptions {
    return {
        port: 0,
        host: "127.0.0.1",
        upstream: `http://127.0.0.1:${upstreamPort}`,
        routes: {},
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: false, injectNudge: false },
        promptCache: { routing: "auto" },
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
    };
}

test("#3581 attribution health: report lands per-agent, status/overview parity, malformed rejected, page ships the banner", async () => {
    const snap = saveEnv();
    const base = mkdtempSync(path.join(tmpdir(), "bili-attribution-health-"));
    let proxy: http.Server | undefined;
    try {
        isolate(base);
        _resetAttributionStatusForTest();
        const upstreamPort = await freePort();
        proxy = await startServer(makeOpts(upstreamPort));
        await once(proxy, "listening");
        const port = (proxy.address() as { port: number }).port;
        const url = (p: string) => `http://127.0.0.1:${port}${p}`;

        // 1. default: nothing reported yet — both surfaces carry {} identically
        let s = await (await fetch(url("/__bili/status"))).json() as { attribution: Record<string, AttributionWireEntry> };
        let o = await (await fetch(url("/__bili/overview"))).json() as { attribution: Record<string, AttributionWireEntry> };
        assert.deepEqual(s.attribution, {}, "status starts empty");
        assert.deepEqual(o.attribution, {}, "overview starts empty");
        assert.deepEqual(o.attribution, s.attribution, "empty-state parity");

        // 2. valid report: per-agent entry (the agent name IS the map key),
        //    byte-identical on both surfaces
        const post = (body: unknown) => fetch(url("/__bili/plugin/attribution"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        const thrown = { state: "threw", refusals: 7, since: 1760000000000 };
        let res = await post({ agent: "dsh", ...thrown });
        assert.equal(res.status, 200, "valid report accepted");
        assert.deepEqual(await res.json(), { ok: true });
        s = await (await fetch(url("/__bili/status"))).json() as { attribution: Record<string, AttributionWireEntry> };
        o = await (await fetch(url("/__bili/overview"))).json() as { attribution: Record<string, AttributionWireEntry> };
        assert.deepEqual(s.attribution.dsh, thrown, "status carries the report verbatim under its agent key");
        assert.deepEqual(o.attribution, s.attribution, "status/overview attribution parity (one shared helper)");

        // second agent coexists; re-reporting one agent is latest-wins
        const none = { state: "none", refusals: 1, since: 1760000001000 };
        res = await post({ agent: "opencode", ...none });
        assert.equal(res.status, 200);
        s = await (await fetch(url("/__bili/status"))).json() as { attribution: Record<string, AttributionWireEntry> };
        assert.deepEqual(s.attribution.opencode, none, "per-agent keys stay independent");
        assert.equal(s.attribution.dsh.refusals, 7, "other agents untouched");
        const updated = { state: "ok", refusals: 0, since: 0 };
        res = await post({ agent: "dsh", ...updated });
        assert.equal(res.status, 200);
        s = await (await fetch(url("/__bili/status"))).json() as { attribution: Record<string, AttributionWireEntry> };
        assert.deepEqual(s.attribution.dsh, updated, "recovery report replaces the degraded episode");

        // 3. malformed reports rejected loudly — never merged into defaults
        for (const bad of [
            { agent: "dsh", state: "exploded", refusals: 1, since: 1 }, // bad state
            { state: "threw", refusals: 1, since: 1 }, // missing agent
            { agent: "", state: "threw", refusals: 1, since: 1 }, // empty agent
        ]) {
            const r = await post(bad);
            assert.equal(r.status, 400, `malformed report rejected: ${JSON.stringify(bad)}`);
            assert.deepEqual(await r.json(), { ok: false, error: "agent and state (ok|none|threw) are required" });
        }
        res = await post({ agent: "pi", state: "none" });
        assert.equal(res.status, 200, "missing refusals/since default to 0");
        s = await (await fetch(url("/__bili/status"))).json() as { attribution: Record<string, AttributionWireEntry> };
        assert.deepEqual(s.attribution.pi, { state: "none", refusals: 0, since: 0 }, "numeric fields default to 0");
        res = await fetch(url("/__bili/plugin/attribution"), { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
        assert.equal(res.status, 400, "non-JSON body rejected");
        assert.deepEqual(await res.json(), { ok: false, error: "invalid JSON" });

        // 4. web surface ships the banner element + localized copy
        const html = renderPage(`http://127.0.0.1:${port}`, VERSION);
        assert.ok(html.includes('id="attribution-banner"'), "page carries the banner div");
        assert.ok(WEB_CLIENT.includes('"attribution-banner"'), "client targets the banner element");
        assert.ok(WEB_CLIENT.includes('t("sys.attribution_broken"'), "client composes the localized notice");
        assert.ok(WEB_CLIENT.includes("escapeHtml(t(\"sys.attribution_broken\""), "agent name/count are HTML-escaped before innerHTML");
    } finally {
        if (proxy) await close(proxy);
        _resetAttributionStatusForTest();
        restoreEnv(snap);
        rmrf(base);
    }
});
