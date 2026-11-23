import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCore, defaultConfig, type Config, type CoreMessage } from "acp-kernel";
import { applyConfiguredCompression } from "../src/external-summary-compress.ts";
import { SummaryCredentialStore } from "../src/external-summary-credentials.ts";
import { _executorForTest } from "../src/external-summary-runtime.ts";
import { createSession } from "../src/session.ts";
import type { RewriteCtx } from "../src/stream.ts";
import { rmrf } from "./tmp-rm.ts";

process.env.NODE_ENV = "test";

const WIRE_SUMMARY = "Historical build completed. Preserve src/example.ts:27, error E_TEST, the no-deploy constraint, and the unfinished testing task.";
const WIRE_RAW = "Historical source src/example.ts:27 E_TEST; do not deploy; still add tests. ".repeat(90);

function wireContext(settings: unknown): RewriteCtx {
    const core = createCore();
    const config = defaultConfig(400_000) as Config & { externalSummary?: unknown };
    config.externalSummary = settings;
    config.preserveRecentMessages = 0;
    config.preserveRecentTokens = 0;
    config.compress.minCompressRange = 100;
    const session = createSession(`issue6903-${Math.random()}`);
    const messages: CoreMessage[] = [
        { id: "history", role: "assistant", contentType: "text", text: WIRE_RAW },
        { id: "current-task", role: "user", contentType: "text", text: "Current task: finish tests without deployment." },
    ];
    session.state = core.processTurn({ messages, state: session.state, config, tokenCount: 10000, renderTags: "text-only" }).state;
    return { core, config, session, messages, log: () => {} };
}
function wireArgs(ctx: RewriteCtx): Record<string, unknown> {
    return { content: [{ startId: ctx.session.state.messageRefs.byRaw.history, endId: ctx.session.state.messageRefs.byRaw.history }] };
}

type Streak = { n: number; lastAt: number; cause?: string };
function streakOf(ctx: RewriteCtx): Streak | undefined {
    return ctx.session.metadata["compressFailStreak"] as Streak | undefined;
}

/** A local summary endpoint returning a fixed status/body, counting every request. */
function summaryServer(status: number, body: string, requests: number[]): http.Server {
    const server = http.createServer((req, res) => {
        req.on("data", () => {});
        req.on("end", () => {
            requests.push(1);
            res.statusCode = status;
            res.setHeader("content-type", "application/json");
            res.end(status === 200 ? JSON.stringify({ status: "completed", output_text: WIRE_SUMMARY }) : body);
        });
    });
    return server;
}
function startServer(server: http.Server): Promise<number> {
    server.listen(0, "127.0.0.1");
    return once(server, "listening").then(() => (server.address() as import("node:net").AddressInfo).port);
}
async function stopServer(server: http.Server): Promise<void> {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
}

const BUDGET = { totalTimeoutMs: 2000, targetTimeoutMs: 1000, maxSummaryBytes: 10_000 };

test("all-fail batches arm the breaker; the 4th call is refused before dispatch (#6903)", async () => {
    const root = mkdtempSync(join(tmpdir(), "bili-6903-arm-"));
    const previous = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = join(root, "config.json");
    const requests: number[] = [];
    const server = summaryServer(403, "forbidden", requests);
    const port = await startServer(server);
    const store = new SummaryCredentialStore();
    store.set("primary", "test-primary-key");
    store.set("secondary", "test-secondary-key");
    const settings = {
        enabled: true, budget: BUDGET,
        targets: [
            { name: "primary", protocol: "responses", url: `http://127.0.0.1:${port}/primary`, model: "summary-primary", credentialRef: "secret:primary" },
            { name: "secondary", protocol: "responses", url: `http://127.0.0.1:${port}/secondary`, model: "summary-secondary", credentialRef: "secret:secondary" },
        ],
    };
    try {
        const ctx = wireContext(settings);
        // Three consecutive all-fail calls: each dispatches to both candidates
        // (failover) → 2 requests per call → 6 total. The 3rd arms the breaker.
        for (let i = 0; i < 3; i += 1) {
            const result = await applyConfiguredCompression(wireArgs(ctx), ctx);
            assert.equal(result.outcome, "refused");
        }
        assert.equal(requests.length, 6, "3 all-fail calls × 2 candidates = 6 endpoint requests");
        const armed = streakOf(ctx);
        assert.ok(armed, "the streak must be recorded after 3 all-fail batches");
        assert.equal(armed.n, 3);
        assert.ok((armed.cause ?? "").startsWith("external-summary-failure"), `cause must be the provider-down verdict, got: ${armed.cause}`);
        // The 3rd (arming) call's receipt carries the pause paragraph.
        const third = await applyConfiguredCompression(wireArgs(ctx), ctx);
        // The 4th call: the breaker is already armed → refused BEFORE dispatch.
        assert.equal(third.outcome, "refused");
        assert.ok(third.text.includes("no summary request was sent"), `4th call must be the armed refusal, got: ${third.text}`);
        assert.ok(!third.text.includes("COMPRESS CIRCUIT BREAKER"), "the armed refusal is a short gate receipt, not the pause paragraph");
        assert.equal(requests.length, 6, "the 4th call must NOT dispatch any endpoint request");
        // Repeated refusals must NOT extend the cooldown (lastAt unchanged).
        assert.equal(streakOf(ctx)?.lastAt, armed.lastAt, "the pre-dispatch gate must not extend the 10-min cooldown");
    } finally {
        await stopServer(server);
        if (previous === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = previous;
        rmrf(root);
    }
});

test("congestion-only batch (no dispatch) does not arm the breaker (#6903)", async () => {
    const root = mkdtempSync(join(tmpdir(), "bili-6903-congestion-"));
    const previous = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = join(root, "config.json");
    const requests: number[] = [];
    const server = summaryServer(200, "", requests);
    const port = await startServer(server);
    const store = new SummaryCredentialStore();
    store.set("primary", "test-primary-key");
    const settings = {
        // A short budget so the victim batch dies in the queue before dispatch.
        enabled: true, budget: { totalTimeoutMs: 200, targetTimeoutMs: 200, maxSummaryBytes: 10_000 },
        targets: [{ name: "primary", protocol: "responses", url: `http://127.0.0.1:${port}/primary`, model: "summary-primary", credentialRef: "secret:primary" }],
    };
    try {
        const ctx = wireContext(settings);
        // Saturate the shared pool: 4 holders each hold a permit for 1500ms.
        const holders = [0, 1, 2, 3].map(() => _executorForTest.executeBatch(
            [{ content: "pool holder", instructions: "hold the permit" }],
            [{ summarize: () => new Promise<string>((resolve) => setTimeout(() => resolve("held"), 1500)) }],
            { totalTimeoutMs: 30_000, targetTimeoutMs: 20_000, maxSummaryBytes: 65536 },
        ));
        try {
            // The victim batch waits in the queue; its 200ms deadline expires
            // before any permit is granted → no candidate call is dispatched.
            const result = await applyConfiguredCompression(wireArgs(ctx), ctx);
            assert.equal(result.outcome, "refused");
            // A congestion-only batch (no dispatch) is NOT a provider failure:
            // the streak must not be incremented.
            assert.equal(streakOf(ctx), undefined, "a congestion-only batch must not arm the breaker");
            assert.equal(requests.length, 0, "no endpoint request may be dispatched while the pool is saturated");
        } finally {
            await Promise.all(holders);
        }
    } finally {
        await stopServer(server);
        if (previous === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = previous;
        rmrf(root);
    }
});

test("decay + success clears the breaker (#6903)", async () => {
    const root = mkdtempSync(join(tmpdir(), "bili-6903-recovery-"));
    const previous = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = join(root, "config.json");
    // The endpoint fails 403 until `flipped`, then returns a valid summary.
    let flipped = false;
    const requests: number[] = [];
    const server = http.createServer((req, res) => {
        req.on("data", () => {});
        req.on("end", () => {
            requests.push(1);
            if (flipped) {
                res.statusCode = 200;
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ status: "completed", output_text: WIRE_SUMMARY }));
            } else {
                res.statusCode = 403;
                res.setHeader("content-type", "application/json");
                res.end("forbidden");
            }
        });
    });
    const port = await startServer(server);
    const store = new SummaryCredentialStore();
    store.set("primary", "test-primary-key");
    const settings = {
        enabled: true, budget: BUDGET,
        targets: [{ name: "primary", protocol: "responses", url: `http://127.0.0.1:${port}/primary`, model: "summary-primary", credentialRef: "secret:primary" }],
    };
    try {
        const ctx = wireContext(settings);
        // Arm the breaker with 3 all-fail calls (1 candidate → 1 request each).
        for (let i = 0; i < 3; i += 1) {
            const result = await applyConfiguredCompression(wireArgs(ctx), ctx);
            assert.equal(result.outcome, "refused");
        }
        assert.equal(streakOf(ctx)?.n, 3, "the breaker must be armed after 3 all-fail calls");
        // Decay the breaker: backdate lastAt past the 10-min window.
        const streak = streakOf(ctx);
        if (streak) streak.lastAt = Date.now() - 11 * 60 * 1000;
        // Flip the endpoint to succeed. The decayed breaker no longer gates,
        // so the call dispatches, succeeds, and clears the streak.
        flipped = true;
        const result = await applyConfiguredCompression(wireArgs(ctx), ctx);
        assert.equal(result.outcome, "applied", `the decayed breaker must allow a recovery dispatch, got: ${result.text}`);
        assert.equal(streakOf(ctx), undefined, "one successful fold must clear the streak");
    } finally {
        await stopServer(server);
        if (previous === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = previous;
        rmrf(root);
    }
});

test("decay recovery: a decayed breaker dispatches again and restarts the count (#6903)", async () => {
    const root = mkdtempSync(join(tmpdir(), "bili-6903-decay-"));
    const previous = process.env.BILI_CONFIG_FILE;
    process.env.BILI_CONFIG_FILE = join(root, "config.json");
    const requests: number[] = [];
    const server = summaryServer(403, "forbidden", requests);
    const port = await startServer(server);
    const store = new SummaryCredentialStore();
    store.set("primary", "test-primary-key");
    const settings = {
        enabled: true, budget: BUDGET,
        targets: [{ name: "primary", protocol: "responses", url: `http://127.0.0.1:${port}/primary`, model: "summary-primary", credentialRef: "secret:primary" }],
    };
    try {
        const ctx = wireContext(settings);
        // Arm the breaker with 3 all-fail calls (1 candidate → 1 request each).
        for (let i = 0; i < 3; i += 1) {
            const result = await applyConfiguredCompression(wireArgs(ctx), ctx);
            assert.equal(result.outcome, "refused");
        }
        assert.equal(streakOf(ctx)?.n, 3);
        // Decay the breaker: backdate lastAt past the 10-min window.
        const streak = streakOf(ctx);
        if (streak) streak.lastAt = Date.now() - 11 * 60 * 1000;
        // The decayed breaker no longer gates: the call dispatches again,
        // fails, and RESTARTS the count at n=1 (not n=4).
        const result = await applyConfiguredCompression(wireArgs(ctx), ctx);
        assert.equal(result.outcome, "refused");
        assert.equal(streakOf(ctx)?.n, 1, "a decayed breaker must restart the count at 1, not continue from 3");
        assert.ok(!result.text.includes("COMPRESS CIRCUIT BREAKER"), "n=1 must not carry the pause paragraph");
    } finally {
        await stopServer(server);
        if (previous === undefined) delete process.env.BILI_CONFIG_FILE;
        else process.env.BILI_CONFIG_FILE = previous;
        rmrf(root);
    }
});
