// The #3148 half-open probe slot is a lease: a request that claims it and is
// then answered locally (the #4204 429 hold) records neither success nor
// failure, and an unexpiring slot failed every request to that host fast —
// for every credential — until the process restarted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest, _resetStoreForTest } from "../src/persist.ts";
import { _resetPluginStateForTest } from "../src/plugin.ts";
import { _resetSessionsForTest } from "../src/session.ts";
import { _resetUpstreamThrottleForTest } from "../src/upstream-throttle.ts";
import {
    getOpenUpstreamCircuits,
    recordUpstreamCircuitFailure,
    recordUpstreamCircuitSuccess,
    upstreamCircuitBlockReason,
    _resetUpstreamCircuitsForTest,
    _setCircuitCooldownForTest,
} from "../src/upstream-alerts.ts";
import { closeServers } from "./server-close-guard.ts";

const URL_A = "http://dead-host.invalid:8443/v1/chat/completions";

function refused(): Error {
    return Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:8443"), { code: "ECONNREFUSED" });
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

test("probe lease: an unsettled probe blocks for one cooldown, then the next probe is granted", () => {
    _resetUpstreamCircuitsForTest();
    const cooldown = 60_000;
    for (let i = 0; i < 3; i++) recordUpstreamCircuitFailure(URL_A, refused(), false);
    const t = Date.now();
    assert.equal(getOpenUpstreamCircuits().length, 1, "open after the 3rd failure");

    const claimedAt = t + cooldown + 1;
    assert.equal(upstreamCircuitBlockReason(URL_A, claimedAt), undefined, "cooldown elapsed: this request becomes THE probe");
    // Single flight is unchanged while the lease runs.
    assert.ok(upstreamCircuitBlockReason(URL_A, claimedAt + 1) !== undefined, "a concurrent request stays blocked");
    assert.ok(upstreamCircuitBlockReason(URL_A, claimedAt + cooldown - 1) !== undefined, "still blocked just before the lease lapses");
    // The claimant never settles. Pre-fix this stayed blocked at any later time.
    assert.equal(upstreamCircuitBlockReason(URL_A, claimedAt + cooldown), undefined, "lease lapsed: the next probe is granted");
    assert.ok(upstreamCircuitBlockReason(URL_A, claimedAt + cooldown + 1) !== undefined, "the re-granted probe is single-flight again");

    recordUpstreamCircuitSuccess(URL_A);
    assert.equal(getOpenUpstreamCircuits().length, 0, "probe success closes the circuit");
});

const REPLY = JSON.stringify({
    id: "chatcmpl-test", object: "chat.completion", created: 1, model: "model-test",
    choices: [{ index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
});

test("e2e: a 429-held credential that takes the half-open probe no longer pins the host open", async () => {
    const envKeys = ["HOME", "XDG_STATE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "BILI_THROTTLE_429", "BILI_REPLAY_RETRY_MAX"] as const;
    const savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
    const root = mkdtempSync(path.join(os.tmpdir(), "circuit-lease-"));
    let mode: "rate-limit-a" | "down" | "healthy" = "rate-limit-a";
    let upstreamHits = 0;
    const upstream = http.createServer((req, res) => {
        // "down" resets the connection before any response — a pre-response
        // transport failure that counts toward opening the circuit.
        if (mode === "down") {
            req.socket.destroy();
            return;
        }
        req.resume();
        req.on("end", () => {
            upstreamHits++;
            if (mode === "rate-limit-a" && req.headers.authorization === "Bearer key-a") {
                res.writeHead(429, { "content-type": "application/json", "retry-after": "120" });
                res.end(JSON.stringify({ error: { type: "rate_limit_error", message: "rate limited" } }));
                return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(REPLY);
        });
    });
    let proxy: http.Server | undefined;
    try {
        for (const k of envKeys.slice(0, 5)) process.env[k] = root;
        process.env.BILI_THROTTLE_429 = "1";
        process.env.BILI_REPLAY_RETRY_MAX = "1";
        _resetStoreForTest();
        _resetPluginStateForTest();
        _resetSessionsForTest();
        _resetUpstreamThrottleForTest();
        _resetUpstreamCircuitsForTest();
        _setCircuitCooldownForTest(200);
        _setStoreForTest(new SessionStore({ dir: path.join(root, "sessions"), enabled: false }));
        upstream.listen(0, "127.0.0.1");
        await once(upstream, "listening");
        const upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
        proxy = await startServer({
            port: 0, host: "127.0.0.1", upstream: upstreamUrl,
            routes: { [upstreamUrl]: { models: { "model-test": { context: 200_000 } } } },
            modelContextLimit: 200_000,
            kernelConfig: defaultConfig(200_000),
            compress: { injectTool: false, injectNudge: false },
            promptCache: { routing: "auto" },
            sessionHeader: "x-acp-session",
            log: false, debug: false, passthrough: false, autoUpdate: false,
            mitm: { enabled: false, domains: [] },
        } as ProxyOptions);
        await once(proxy, "listening");
        const origin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
        const send = async (key: string): Promise<number> => {
            const r = await fetch(`${origin}/bili/${upstreamUrl}/v1/chat/completions`, {
                method: "POST",
                headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "x-acp-session": `lease-${key}` },
                body: JSON.stringify({ model: "model-test", messages: [{ role: "user", content: "hello" }], max_tokens: 16, stream: false }),
            });
            await r.arrayBuffer();
            return r.status;
        };

        assert.equal(await send("key-a"), 429, "key-a is rate limited upstream: its 429 hold arms");
        mode = "down";
        for (let i = 0; i < 3; i++) await send("key-b");
        assert.equal(getOpenUpstreamCircuits().length, 1, "three pre-response failures open the host's circuit");
        await sleep(300);
        // Cooldown elapsed: the held key-a request becomes the probe and is
        // answered locally by its hold without contacting the upstream.
        assert.equal(await send("key-a"), 429, "the held credential is answered locally");
        mode = "healthy";
        const hitsBefore = upstreamHits;
        await sleep(300);
        assert.equal(await send("key-b"), 200, "after one more cooldown the next request probes the recovered upstream");
        assert.ok(upstreamHits > hitsBefore, "the probe reached the upstream");
        assert.equal(getOpenUpstreamCircuits().length, 0, "the successful probe closes the circuit");
    } finally {
        await closeServers([proxy, upstream].filter((s): s is http.Server => s?.listening === true), "circuit-lease");
        _resetUpstreamCircuitsForTest();
        _resetUpstreamThrottleForTest();
        for (const k of envKeys) {
            if (savedEnv[k] === undefined) delete process.env[k];
            else process.env[k] = savedEnv[k];
        }
        rmSync(root, { recursive: true, force: true });
    }
});
