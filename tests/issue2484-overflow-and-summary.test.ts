import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.NODE_ENV = "test";

// #2484: a session far over its window dead-looped because a gateway relayed
// the model provider's overflow rejection under HTTP 502 (body: "exceeds the
// context window") instead of 400. Three interlocking mechanisms:
//   D2. inspectContextOverflow refused every 5xx, so the overflow arm never
//       fired — and when it did fire the estimate-grade failure-shrink demoted
//       it back to "estimate", dropping baselineFloorRaw below the probe
//       threshold and re-firing the forward-probe loop every turn.
//   D4. a misconfigured external-summary chain collapsed to one opaque
//       "candidate unavailable" placeholder with no log — silent degradation.
//   D5. the unusable-summary note dropped the batch status + per-attempt
//       outcomes, so timeout vs error vs cancelled was indistinguishable.
// (D1 = the inspectContextOverflow 5xx gate itself, pinned in
//  context-overflow.test.ts; D3 = the widened totalTimeoutMs cap, pinned in
//  external-summary-settings.test.ts.)

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { NamedProviderRecipe, ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { listSessions, _resetSessionsForTest, type Session } from "../src/session.ts";
import { setLogCapture } from "../src/logger.ts";
import { ConfiguredSummaryPlan } from "../src/external-summary-runtime.js";
import { SummaryCredentialStore } from "../src/external-summary-credentials.js";
import { expandExternalSummaryChain, parseExternalSummaryChain } from "../src/external-summary-settings.js";
import { describeExternalSummaryFailure } from "../src/preflight.js";

const WINDOW = 120_000;
const OVERFLOW_BODY = '{"error":{"message":"Your input exceeds the context window","type":"upstream_error"}}';

// ── D2: the overflow arm must survive the concurrent failure-shrink ──────────

/** Relay that answers every request with a fixed status + body (the gateway
 *  relaying the provider's overflow rejection under 502). */
function makeRelay(status: number, body: string) {
    const server = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
            res.writeHead(status, { "content-type": "application/json" });
            res.end(body);
        });
    });
    return server;
}

async function startHarness(status: number, body: string) {
    const logs: string[] = [];
    setLogCapture((level, msg) => { logs.push(`${level} ${msg}`); });
    _resetSessionsForTest();
    const relay = makeRelay(status, body);
    relay.listen(0, "127.0.0.1");
    await once(relay, "listening");
    const upstreamPort = (relay.address() as { port: number }).port;
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    const proxy = await startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "gpt-test": { context: WINDOW } } } },
        modelContextLimit: WINDOW,
        kernelConfig: defaultConfig(WINDOW),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: true,
        debug: false,
        passthrough: false,
        compat: { roles: {} }, streamErrorShape: "protocol", passthroughSource: null, autoRestartOnUpdate: false, updateTag: "latest", advisoryCheck: false, releaseNotesCheck: false,
        autoUpdate: false,
        mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
    await once(proxy, "listening");
    const url = `http://127.0.0.1:${(proxy.address() as { port: number }).port}/bili/http://127.0.0.1:${upstreamPort}/v1/chat/completions`;
    const post = (messages: Array<{ role: string; content: unknown }>) => fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-test", max_tokens: 1024, stream: true, messages }),
    });
    const anonSession = (): Session => {
        const s = listSessions().find((x) => x.metadata.anonymousPrefixAffinity);
        assert.ok(s, "an anonymous prefix-affinity session exists");
        return s!;
    };
    const close = async () => {
        await new Promise<void>((r) => proxy.close(() => r()));
        await new Promise<void>((r) => relay.close(() => r()));
    };
    return { logs, post, anonSession, close };
}

test("#2484 D2: a 5xx carrying an overflow marker keeps the overflow-arm (not demoted to estimate)", async () => {
    const h = await startHarness(502, OVERFLOW_BODY);
    try {
        const r1 = await h.post([
            { role: "user", content: "hello, please help me with task A" },
            { role: "assistant", content: "sure, here is step one." },
            { role: "user", content: "continue with step two" },
        ]);
        assert.equal(r1.status, 502, "the gateway 502 passes through verbatim");
        await r1.text();
        const s = h.anonSession();
        // Pre-fix: armFailureShrink ran right after armOverflowShrink in the
        // !ok branch and overwrote lastInputTokensSource back to "estimate",
        // dropping baselineFloorRaw and re-arming the forward-probe loop on
        // every turn. Post-fix the upstream-proven ceiling survives.
        assert.equal(s.stats.lastInputTokensSource, "overflow-arm", "the overflow arm is not demoted by the failure-shrink estimate");
    } finally {
        await h.close();
    }
});

// ── D4: a misconfigured chain is logged, not silently degraded ───────────────

test("#2484 D4: an unresolvable summary credential warns once with the reference named", async () => {
    const logs: string[] = [];
    setLogCapture((level, msg) => { logs.push(`${level} ${msg}`); });
    const rootPath = mkdtempSync(join(tmpdir(), "bili-issue2484-"));
    const store = new SummaryCredentialStore(join(rootPath, "keys.json"));
    const recipes: Record<string, NamedProviderRecipe> = {
        glm: { baseUrl: "https://open.bigmodel.cn/api/paas/v4", api: "openai", apiKeyEnv: "BILI_TEST_MISSING_KEY", models: { "glm-x": {} } },
    };
    const planSettings = expandExternalSummaryChain(parseExternalSummaryChain({ enabled: true, targets: ["glm/glm-x"] }), recipes);
    try {
        // An empty env guarantees the `env:BILI_TEST_MISSING_KEY` reference
        // resolves to nothing → the candidate becomes a placeholder.
        new ConfiguredSummaryPlan(planSettings, store, {});
        const warns = logs.filter((l) => l.includes("unavailable") && l.includes("BILI_TEST_MISSING_KEY"));
        assert.equal(warns.length, 1, "exactly one diagnostic naming the unresolved reference");
        // Reconstructing the same broken chain must not spam a second warn.
        new ConfiguredSummaryPlan(planSettings, store, {});
        assert.equal(logs.filter((l) => l.includes("unavailable") && l.includes("BILI_TEST_MISSING_KEY")).length, 1, "warn-once across reconstructions");
    } finally {
        setLogCapture(null);
    }
});

// ── D5: the unusable-summary diagnostic carries the real batch detail ────────

test("#2484 D5: describeExternalSummaryFailure surfaces the batch stop reason + per-attempt outcomes", () => {
    assert.equal(
        describeExternalSummaryFailure({ status: "cancelled", results: [{ status: "cancelled", attempts: [{ targetIndex: 0, outcome: "cancelled" }] }] }),
        "batch=cancelled result=cancelled attempts=[t0:cancelled]",
    );
    assert.equal(
        describeExternalSummaryFailure({ status: "deadline", results: [] }),
        "batch=deadline (no result)",
    );
    assert.equal(
        describeExternalSummaryFailure({ status: "finished", results: [{ status: "failed", reason: "exhausted", attempts: [{ targetIndex: 0, outcome: "timeout" }, { targetIndex: 1, outcome: "error" }] }] }),
        "batch=finished result=failed reason=exhausted attempts=[t0:timeout,t1:error]",
    );
    assert.equal(
        describeExternalSummaryFailure({ status: "failed", reason: "invalid_plan", results: [] }),
        "batch=failed reason=invalid_plan",
    );
});
