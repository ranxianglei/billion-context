import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { _resetSessionsForTest, getSession } from "../src/session.ts";

// #4501: providers.<url>.models.<model>.output (and .context) were unreadable for
// PATH-STYLE lane requests — POST /v1/chat/completions straight at the proxy's
// default upstream, no /bili/ tunnel, no absolute form, non-MITM. handle() keyed
// every providers.* lookup on route?.rewrittenUrl, which resolveUpstream() leaves
// undefined for exactly those requests, so resolveKnownOutputCeiling fell through
// to the registry (no entry for e.g. deepseek-flash) and the ceiling stayed
// unknown: the #3438 mid-band rescue was never armed and its "NO known output
// ceiling" warn could not be silenced by config. The fix reconstructs the full
// destination URL (opts.upstream + path) as the single config-matching basis.
// These pin it end-to-end: a path-style dsh-lane request now resolves the declared
// output ceiling and restores a collapsed mid-band budget up to it.

const MODEL = "deepseek-flash";
const CEILING = 384_000;
const SESSION = "issue-4501-sess";

interface Rig {
    proxyPort: number;
    upstreamPort: number;
    proxy: http.Server;
    upstream: http.Server;
    lastBody: Record<string, unknown> | null;
}

async function startRig(declaredOutput?: number): Promise<Rig> {
    const rig: Rig = { proxyPort: 0, upstreamPort: 0, proxy: null as unknown as http.Server, upstream: null as unknown as http.Server, lastBody: null };
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            rig.lastBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                id: "cmpl-4501", object: "chat.completion", created: 0, model: MODEL,
                choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
            }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    // The proxy's DEFAULT upstream origin — a path-style request forwards to
    // opts.upstream + urlPath, and providers.* keys must match that same URL.
    const origin = `http://127.0.0.1:${upstreamPort}`;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    _resetSessionsForTest();
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: origin,
        routes: declaredOutput !== undefined
            ? { [origin]: { models: { [MODEL]: { output: declaredOutput } } } }
            : { [origin]: {} },
        modelContextLimit: 1_000_000,
        kernelConfig: defaultConfig(1_000_000),
        compress: { injectTool: true, injectNudge: true },
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
    } as ProxyOptions);
    await once(proxy, "listening");
    rig.proxy = proxy; rig.upstream = upstream; rig.proxyPort = (proxy.address() as { port: number }).port; rig.upstreamPort = upstreamPort;
    return rig;
}

async function closeRig(rig: Rig): Promise<void> {
    rig.proxy.close();
    rig.proxy.closeIdleConnections?.();
    await once(rig.proxy, "close");
    rig.upstream.close();
    rig.upstream.closeIdleConnections?.();
    await once(rig.upstream, "close");
}

const TOOL = [{ type: "function", function: { name: "bash", description: "run a command", parameters: { type: "object", properties: {} } } }];
const HEADERS: Record<string, string> = {
    "content-type": "application/json",
    "x-acp-session": SESSION,
    "x-bili-plugin": "dsh",
    "x-bili-plugin-conversation": SESSION,
};

test("#4501: path-style dsh-lane request resolves the configured output ceiling and restores the mid-band budget", async () => {
    const rig = await startRig(CEILING);
    try {
        // PATH-STYLE: POST straight at the proxy's default upstream — no /bili/,
        // no absolute form. This is the dsh desktop shape that lost the config.
        const url = `http://127.0.0.1:${rig.proxyPort}/v1/chat/completions`;
        // 8192 sits above the <=200 starve gate but far below the declared 384K
        // ceiling: on the dsh lane (host stamps maxTokens by contract) that is the
        // raw-history collapse signature #3438 exists to rescue.
        const body = { model: MODEL, max_tokens: 8192, tools: TOOL, messages: [{ role: "user", content: "hello" }] };
        const r = await fetch(url, { method: "POST", headers: HEADERS, body: JSON.stringify(body) });
        assert.equal(r.status, 200);
        await r.text();

        const fwd = rig.lastBody;
        assert.ok(fwd, "upstream received the request");
        assert.equal(fwd?.max_tokens, CEILING, "the declared output ceiling floors the restore on a PATH-STYLE request (#4501)");

        const s = getSession(SESSION);
        assert.ok(s, "session row exists");
        assert.equal(s.metadata.outputBudgetDegraded, undefined, "a resolved ceiling leaves no no-ceiling degraded state behind");
    } finally {
        await closeRig(rig);
    }
});

test("#4501 control: the SAME path-style request with NO declared ceiling forwards the mid-band value verbatim (pre-fix behaviour)", async () => {
    const rig = await startRig(undefined);
    try {
        const url = `http://127.0.0.1:${rig.proxyPort}/v1/chat/completions`;
        const body = { model: MODEL, max_tokens: 8192, tools: TOOL, messages: [{ role: "user", content: "hello" }] };
        const r = await fetch(url, { method: "POST", headers: HEADERS, body: JSON.stringify(body) });
        assert.equal(r.status, 200);
        await r.text();

        const fwd = rig.lastBody;
        assert.ok(fwd, "upstream received the request");
        assert.equal(fwd?.max_tokens, 8192, "with no known ceiling bili cannot judge collapse from intent — forwarded verbatim");
        const s = getSession(SESSION);
        assert.ok(s, "session row exists");
        // The unrescuable mid-band takes the healthy branch (collapse needs a
        // known ceiling), which poisons the high-water with the starved value —
        // the exact #4501 impact-2 residue a declared ceiling prevents.
        assert.equal(s.metadata.outputBudgetHighWater, 8192, "the verbatim mid-band poisons the high-water with the starved value");
    } finally {
        await closeRig(rig);
    }
});
