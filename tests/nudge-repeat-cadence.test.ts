process.env.NODE_ENV = "test";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { AddressInfo } from "node:net";
import { defaultConfig } from "acp-kernel";
import { startServer, type ProxyOptions } from "../src/server.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";

// #436: a nudge that the model ignores leaves the kernel's growth reference
// (lastNudgeShownTokens) pinned at the injection point, so the full growth
// floor must re-accumulate before the kernel nudges again — even when a large
// compressible range is sitting ready. maybeForceRepeatNudge (src/server.ts)
// shortens that cadence on the billion-context side: once a prior nudge is
// pending (model never compressed) and a ready range >= the interval exists,
// re-nudge at ~half the growth floor instead of waiting the full floor.
//
// This drives the real proxy (startServer) against a local upstream that
// reports a growing prompt_tokens each turn, so bili's tokenCount (the previous
// turn's usage) climbs 10k → 20k → 30k → 40k → 42k:
//   turn 1: tokenCount 0      → no nudge (baseline not set)
//   turn 2: tokenCount 10k    → no nudge (growth 0; baseline set to 10k here)
//   turn 3: tokenCount 20k    → no nudge (growth 10k < floor 20k)
//   turn 4: tokenCount 30k    → KERNEL nudge (growth 20k >= floor, pendingT1 ready)
//   turn 5: tokenCount 40k    → kernel silent (growth 10k < floor since turn 4)
//                                but the model ignored the turn-4 nudge, so the
//                                FORCED repeat nudge fires.
// A nudge surfaces as one extra trailing user message in the forwarded payload.

const PROMPT_TOKENS = [10_000, 20_000, 30_000, 40_000, 42_000];

function okJson(promptTokens: number) {
    return JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 1,
        model: "test-model",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: promptTokens, completion_tokens: 3, total_tokens: promptTokens + 3 },
    });
}

// A system prompt + many long user/assistant pairs + a small recent tail. The
// long pairs sit well outside the protected recent zone, so the kernel reports
// a large tier-1 pending range (>= the 5k nudge interval) on every turn.
function historyMessages(): Array<{ role: string; content: string }> {
    const msgs: Array<{ role: string; content: string }> = [
        { role: "system", content: "You are a helpful assistant." },
    ];
    for (let i = 0; i < 16; i++) {
        msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: `Turn ${i} detail. ${"x".repeat(5000)}` });
    }
    msgs.push({ role: "user", content: "Please continue." });
    return msgs;
}

test("nudge repeat cadence: forced nudge fires when the model ignored the prior one", async () => {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});

    const received: Array<Array<{ role: string; content?: unknown }>> = [];
    let turn = 0;
    const upstream = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
            const parsed = JSON.parse(body);
            received.push(parsed.messages ?? []);
            const promptTokens = PROMPT_TOKENS[turn] ?? PROMPT_TOKENS[PROMPT_TOKENS.length - 1];
            turn++;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(okJson(promptTokens));
        });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const upstreamPort = (upstream.address() as AddressInfo).port;

    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: `http://127.0.0.1:${upstreamPort}`,
        routes: {},
        modelContextLimit: 200_000,
        kernelConfig: defaultConfig(200_000),
        compress: { injectTool: true, injectNudge: true, nudgeGrowthTokens: 5_000 },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
    const sess = "nudge-repeat-test";

    try {
        for (let i = 0; i < 5; i++) {
            const resp = await fetch(url, {
                method: "POST",
                headers: { "content-type": "application/json", "x-acp-session": sess },
                body: JSON.stringify({ model: "test-model", messages: historyMessages() }),
            });
            assert.equal(resp.status, 200, `turn ${i + 1} should be proxied`);
            await resp.text();
        }

        const base = received[0].length;
        assert.equal(received[1].length, base, "turn 2: no nudge (growth 0, baseline just set)");
        assert.equal(received[2].length, base, "turn 3: no nudge (growth 10k < floor 20k)");
        assert.equal(received[3].length, base + 1, "turn 4: kernel nudge appended (growth 20k >= floor)");
        assert.equal(received[4].length, base + 1, "turn 5: forced repeat nudge appended (model ignored turn 4)");

        const last = received[4][received[4].length - 1] as { role: string; content?: unknown };
        assert.equal(last.role, "user", "the nudge is a trailing user message");
        assert.ok(typeof last.content === "string" && last.content.length > 0, "nudge carries rendered text");
    } finally {
        proxy.close();
        upstream.close();
    }
});
