import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions } from "../src/session.ts";

// #4205: output-headroom caliber split + route-scoped reservation (redo of the
// reverted #4184, whose global anthropic flip red-lined ~40 tests that pin the
// UNRESERVED window). Two things must hold together:
//   1. CALIBER — `metadata.effectiveContextLimit` stays the unreserved window
//      N for every display surface (status panel / acp_status / web); the
//      reserved window R the kernel actually judges against is recorded per
//      request in `metadata.reservedContextLimit`. Logs carry both numbers.
//   2. ROUTE SCOPE — the anthropic exemption is evidence-based, not a global
//      boolean: real-Claude routes (api.anthropic.com host or claude-* model
//      id) keep reserving zero; wrapper fronts that bill completion inside the
//      input wall (#3900: DeepSeek /anthropic, 1,070,269 + 128,000 vs
//      1,048,576) reserve like every other wire. The #3900 regression shape:
//      a payload that fits the wall but not the reserved band must fail fast
//      LOCALLY on a reserving route — the doomed body never reaches upstream —
//      while the identical payload rides through on an exempt route.

const WINDOW = 100_000;
const MAX_TOKENS = 20_000;
// Default cap 0.25 x 100_000 = 25_000 > 20_000, so the full max_tokens is
// reserved: R = 80_000.
const RESERVED_WINDOW = WINDOW - MAX_TOKENS;
// 368_000 ASCII chars = exactly 92_000 tokens at the kernel's chars/4 meter —
// inside (R=80_000, N=100_000): over the reserved band, under the wall.
const FILLER = "x".repeat(368_000);

interface Rig {
    proxyPort: number;
    upstreamPort: number;
    proxy: http.Server;
    upstream: http.Server;
    /** model id of every MAIN-LANE request that reached the mock upstream
     *  (preflight's own summary probes carry a different max_tokens and do
     *  not count — the regression is about the client's body leaving) */
    mainModels: string[];
}

async function startRig(): Promise<Rig> {
    const rig: Rig = { proxyPort: 0, upstreamPort: 0, proxy: undefined as unknown as http.Server, upstream: undefined as unknown as http.Server, mainModels: [] };
    const upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { model?: string; max_tokens?: number } = {};
            try { parsed = JSON.parse(raw) as { model?: string; max_tokens?: number }; } catch { /* keep default */ }
            const model = parsed.model ?? "unknown";
            if (parsed.max_tokens === MAX_TOKENS) rig.mainModels.push(model);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id: "msg_s", type: "message", role: "assistant", model, content: [{ type: "text", text: "s" }], stop_reason: "end_turn", usage: { input_tokens: 500, output_tokens: 5 } }));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    rig.upstream = upstream;
    const upstreamPort = (upstream.address() as { port: number }).port;
    rig.upstreamPort = upstreamPort;

    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "deepseek-flash": { context: WINDOW }, "claude-x": { context: WINDOW } } } },
        modelContextLimit: WINDOW,
        kernelConfig: defaultConfig(WINDOW),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    rig.proxy = proxy;
    rig.proxyPort = (proxy.address() as { port: number }).port;
    return rig;
}

async function post(rig: Rig, sid: string, model: string, messages: Array<{ role: string; content: string }>): Promise<Response> {
    return fetch(`http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": sid },
        body: JSON.stringify({ model, max_tokens: MAX_TOKENS, stream: false, messages }),
    });
}

function meta(sid: string): { effectiveContextLimit?: number; reservedContextLimit?: number } {
    const sess = listSessions().find((s) => s.id === sid);
    return (sess?.metadata ?? {}) as { effectiveContextLimit?: number; reservedContextLimit?: number };
}

async function closeRig(rig: Rig): Promise<void> {
    rig.proxy.close();
    rig.proxy.closeIdleConnections?.();
    await once(rig.proxy, "close");
    rig.upstream.close();
    rig.upstream.closeIdleConnections?.();
    await once(rig.upstream, "close");
}

test("#4205 caliber: a reserving route records N in effectiveContextLimit and R in reservedContextLimit", async () => {
    const rig = await startRig();
    try {
        const r = await post(rig, "caliber-wrap", "deepseek-flash", [{ role: "user", content: "hi" }]);
        assert.equal(r.status, 200);
        await r.text();
        const m = meta("caliber-wrap");
        assert.equal(m.effectiveContextLimit, WINDOW, "display field keeps the unreserved window N");
        assert.equal(m.reservedContextLimit, RESERVED_WINDOW, "decision field records the reserved window R");
    } finally {
        await closeRig(rig);
    }
});

test("#4205 exemption: a real-Claude route reserves nothing, both fields record N", async () => {
    const rig = await startRig();
    try {
        const r = await post(rig, "caliber-claude", "claude-x", [{ role: "user", content: "hi" }]);
        assert.equal(r.status, 200);
        await r.text();
        const m = meta("caliber-claude");
        assert.equal(m.effectiveContextLimit, WINDOW);
        assert.equal(m.reservedContextLimit, WINDOW, "claude-* model id carries separate-output-budget evidence");
    } finally {
        await closeRig(rig);
    }
});

test("#4205 #3900-class: doomed body fails fast locally on the reserving route, rides through on the exempt route", async () => {
    const rig = await startRig();
    try {
        // Wrapper front (no separate-output-budget evidence): R = 80_000.
        const w1 = await post(rig, "wrap-sess", "deepseek-flash", [{ role: "user", content: "hi" }]);
        assert.equal(w1.status, 200);
        await w1.text();
        // Usage report from turn 1 settles a usage-grade baseline, so an
        // over-band turn 2 is judged locally instead of forwarded for
        // evidence (#3146 forward-once only covers unknown baselines).
        const w2 = await post(rig, "wrap-sess", "deepseek-flash", [
            { role: "user", content: "hi" },
            { role: "assistant", content: "s" },
            { role: "user", content: FILLER },
        ]);
        await w2.text();
        // Local refusal: deterministic exhaustion (nothing foldable) with the
        // calibrated meter agreeing the payload is over R. 413 is the
        // deterministic verdict; 502 is the relay-dependent variant. Either
        // way the body stayed local — the #3900 regression was the body
        // reaching upstream and burning a guaranteed 400.
        assert.ok(w2.status === 413 || w2.status === 502, `expected local fail-fast, got ${w2.status}`);
        assert.deepEqual(rig.mainModels.filter((m) => m === "deepseek-flash"), ["deepseek-flash"], "doomed turn-2 body never left the proxy as a main-lane forward");

        // Control: identical payload on an exempt route (limit N = 100_000)
        // fits and rides through untouched.
        const c1 = await post(rig, "ctrl-sess", "claude-x", [{ role: "user", content: "hi" }]);
        assert.equal(c1.status, 200);
        await c1.text();
        const c2 = await post(rig, "ctrl-sess", "claude-x", [
            { role: "user", content: "hi" },
            { role: "assistant", content: "s" },
            { role: "user", content: FILLER },
        ]);
        assert.equal(c2.status, 200, "identical payload fits the unreserved wall on the exempt route");
        await c2.text();
        assert.deepEqual(rig.mainModels.filter((m) => m === "claude-x"), ["claude-x", "claude-x"], "both turns reached upstream on the exempt route");
    } finally {
        await closeRig(rig);
    }
});
