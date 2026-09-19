import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { afterEach, test } from "node:test";
import { createCore, defaultConfig, defaultPrompts, type CoreMessage } from "acp-kernel";
import { preflightCompress, type PreflightDeps } from "../src/preflight.ts";
import { _liveUpstreamTimersForTest, _resetFetchUtilForTest } from "../src/fetch-util.ts";
import { getSession } from "../src/session.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _resetForTest as resetRegistryForTest, _setForTest as setRegistryForTest } from "../src/registry.ts";

process.env.NODE_ENV = "test";
_setStoreForTest(new SessionStore({ enabled: false }));

const SUMMARY = "SUMMARY: keep the task goal, exact acceptance criteria and next step; the repeated fixture output is disposable.";

afterEach(() => {
    assert.equal(_liveUpstreamTimersForTest(), 0, "each attempt releases its upstream idle timer");
    _resetFetchUtilForTest();
    resetRegistryForTest();
});

// #853 end-to-end: the summary call carries the raised 32k default output cap
// (the old 8192 starved reasoning-on-by-default models — observed
// content:"" + finish_reason:"length" on deepseek-flash), and clamps it down
// to the model's known models.dev ceiling when that is smaller. The window is
// large enough that #987's headroom clamp (input+output <= window) never
// engages here — this test isolates the registry-ceiling clamp only.
test("#853 summary output cap: 32k default, clamped to known model ceiling", async () => {
    // A live capped entry in the bundled models.dev snapshot, so the
    // assertion survives snapshot regeneration. The relay-style bare name
    // resolves through the registry's cross-provider scan.
    setRegistryForTest({
        "swiss-ai/apertus-8b": { limit: { context: 65536, output: 8192 } },
        "deepseek/deepseek-v4-flash": { limit: { context: 1000000, output: 384000 } },
    });

    for (const [model, expectedCap, label] of [
        ["test-model", 32768, "unknown model gets the full 32k default"],
        ["deepseek-v4-flash", 32768, "high-ceiling model keeps the full 32k default"],
        ["apertus-8b", 8192, "known-ceiling model is clamped to its cap"],
    ] as const) {
        const bodies: Record<string, unknown>[] = [];
        const server = http.createServer((req, res) => {
            let raw = "";
            req.on("data", (c) => (raw += c));
            req.on("end", () => {
                const body = JSON.parse(raw);
                bodies.push(body);
                assert.equal(body.stream, false, "fixture relies on the non-stream summary path");
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: SUMMARY } }] }));
            });
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const { port } = server.address() as { port: number };

        const session = getSession(`summary-cap-${randomUUID()}`);
        const messages: CoreMessage[] = [
            { id: "first", role: "user", contentType: "text", text: "Keep the task goal and acceptance criteria." },
            { id: "large", role: "assistant", contentType: "text", text: "FILLER_".repeat(60000) },
            { id: "last", role: "user", contentType: "text", text: "Continue the task." },
        ];
        const deps: PreflightDeps = {
            core: createCore(), session,
            config: defaultConfig(100_000, { preserveRecentMessages: 0, preserveRecentTokens: 0 }),
            prompts: defaultPrompts, protocol: "openai",
            url: `http://127.0.0.1:${port}/v1/messages`,
            headers: {}, model,
            log: () => {},
        };
        try {
            await preflightCompress(deps, messages);
            // #668: a span dominated by one huge message is split into
            // token-budgeted chunks (one summary call each, so every call fits
            // the window) — the cap must hold on ALL of them.
            assert.ok(bodies.length >= 1, "at least one summary call");
            for (const b of bodies) {
                assert.equal(b.max_tokens, expectedCap, label);
            }
        } finally {
            server.close();
            await once(server, "close");
        }
    }
});
