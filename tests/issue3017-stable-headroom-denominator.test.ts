import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

process.env.NODE_ENV = "test";

// #3017: the headroom JUDGE denominator (the wall nudge/emergency usage% is
// measured against) must be STABLE within a session. Before the fix it was seeded
// from the PER-REQUEST wire max_tokens, so the same input mapped to a different
// usage% on every turn — the #3004 incident logged four walls (984464 / 1037424 /
// 1036971 / 1048500) in one session, two within the same second. These e2e tests
// pin the fix: the wall is now pinned to the client-configured / model-declared
// output ceiling and does NOT move when the per-request wire max_tokens changes.
// Unknown model → full window (today's no-reservation behavior).

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions } from "../src/session.ts";

const WINDOW = 1_050_000; // the #3004 incident's ~1M base window
const OUTPUT_CEILING = 12_576; // stable declared output (below the 25% cap)
const EXPECTED_EFFECTIVE = WINDOW - Math.min(OUTPUT_CEILING, Math.floor(0.25 * WINDOW)); // 1_037_424

function makeUpstream(): http.Server {
    return http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ id: "c3017", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: "c3017", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: "c3017", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 3, total_tokens: 103 } })}\n\n`);
        res.end(`data: [DONE]\n\n`);
    });
}

type Rig = { proxyPort: number; upstreamPort: number; proxy: http.Server; upstream: http.Server };

async function startRig(model: string, declOutput: number | undefined): Promise<Rig> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const upstream = makeUpstream();
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { [model]: { context: WINDOW, ...(declOutput !== undefined ? { output: declOutput } : {}) } } } },
        modelContextLimit: WINDOW,
        kernelConfig: defaultConfig(WINDOW),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    return { proxyPort: (proxy.address() as { port: number }).port, upstreamPort, proxy, upstream };
}

async function drive(rig: Rig, session: string, model: string, maxTokens: number): Promise<number | undefined> {
    const r = await fetch(`http://127.0.0.1:${rig.proxyPort}/bili/http://127.0.0.1:${rig.upstreamPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-acp-session": session },
        body: JSON.stringify({ model, max_tokens: maxTokens, stream: true, messages: [{ role: "user", content: "hello" }] }),
    });
    assert.equal(r.status, 200, `request must succeed, got ${r.status}: ${await r.text().catch(() => "")}`);
    await r.body?.cancel().catch(() => { /* drained */ });
    return listSessions()[0]?.metadata.effectiveContextLimit as number | undefined;
}

test("#3017 e2e: same session+model → constant denominator across wildly different wire max_tokens", async () => {
    const rig = await startRig("gpt-stable", OUTPUT_CEILING);
    try {
        // The #3004 incident's per-request samples, all different from each other and
        // from the declared ceiling. Old code gave a DIFFERENT wall for each (e.g. the
        // 65536 turn → WINDOW−65536 = 984464); now the wall is fixed at
        // WINDOW − min(OUTPUT_CEILING, 25%) no matter what the wire carries.
        const a = await drive(rig, "s3017-a", "gpt-stable", 65_536);
        const b = await drive(rig, "s3017-a", "gpt-stable", 13_029);
        const c = await drive(rig, "s3017-a", "gpt-stable", 1_500);
        assert.equal(a, EXPECTED_EFFECTIVE, `first turn must use the stable ceiling, not the wire 65536 (old code gave ${WINDOW - 65_536}), got ${a}`);
        assert.equal(b, EXPECTED_EFFECTIVE, `wall must not move when the wire sample changes, got ${b}`);
        assert.equal(c, EXPECTED_EFFECTIVE, `wall must stay put across all turns, got ${c}`);
    } finally {
        rig.proxy.close();
        rig.upstream.close();
        await Promise.allSettled([once(rig.proxy, "close"), once(rig.upstream, "close")]);
    }
});

test("#3017 e2e: unknown model keeps today's no-reservation behavior (full window)", async () => {
    const rig = await startRig("zzz-unlisted", undefined);
    try {
        const a = await drive(rig, "s3017-u", "zzz-unlisted", 65_536);
        const b = await drive(rig, "s3017-u", "zzz-unlisted", 1_500);
        assert.equal(a, WINDOW, `unknown model → no stable ceiling → full window (== today), got ${a}`);
        assert.equal(b, WINDOW, `unknown model stays full-window regardless of the wire sample, got ${b}`);
    } finally {
        rig.proxy.close();
        rig.upstream.close();
        await Promise.allSettled([once(rig.proxy, "close"), once(rig.upstream, "close")]);
    }
});
